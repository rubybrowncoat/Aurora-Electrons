WITH const AS 
(
	--IMPORTANT:
	--		This script assumes you are playing as the most recently created player race in the most recently created game in your database.
	--		If this is not the case, provide the appropriate GameID and RaceID values in the first two lines after "select" below.
	--Steps:
	-- 1) save Aurora, then save Aurora again (which makes a backup of the database at the current game time)
	-- 2) close Aurora
	-- 3) replace appropriate values in the select statement immediately below (colony name, ship class name, number to build, industry percentage to use, pause, queue, components to exclude)
	-- 4) make sure the "INSERT INTO..." line is commented out ( begins with two dashes ) and the "SELECT" line immediately after it is not commented out
	-- 5) run the script (F5 in most software). It will return a list of the tasks that will be added to the queue. Make sure it looks correct.
	-- 6) remove the "--" from the beginning of the "INSERT INTO..." line.
	-- 7) run the script. you have now inserted the tasks into the construction queue at your designated colony.
	-- 8) commit the change to the database. (In DB Browser for SQLite, click the "Write Changes" button above.)
	-- 9) open Aurora and verify the new production orders.
	-- 10) if something went wrong and you need to undo the changes:
	--		10a) Close Aurora (without saving) and delete AuroraDB.db from your game folder
	--		10b) In the same folder, rename AuroraDBSaveBackup.db to AuroraDB.db
	--		10c) Open Aurora. You will see the state the game was in prior to running the script.
	--
	--Note:
	--	Due to rounding issues in Aurora, the game may interpret the total industry percentage of the tasks that this script creates as higher than the amount you specified by a very tiny amount (less than 0.0001).
	--	Therefore if you are trying to add other tasks to the queue after running this script, you may need to subtract a very tiny amount (like 0.0001) from the industry percentage value for Aurora to allow it.
	
	select
		--------------change the values in these lines as needed
		-- the colony where you want the components to be built
		
		'ZZZ-AAst56' as PopulationName						
		
		-- the total percentage of the construction queue to use (1-100)
		-- note that this script doesn't enforce any rules about total industry percentage used
		,100.0 as IndustryPercentageToUse					
		
		-- 1 if you want the tasks to be paused
		,0 as Pause										
		
		-- 0 if you want the tasks to go into the active build orders; non-0 if you want them at the end of the build queue
		,0 as Queue										
		
		-- 1 if you want to reduce build amounts by amounts in the colony's stockpile. 0 if you want to ignore the stockpile.
		,1 as UseStockpile								
		--------------
		
		-- if you aren't playing the most recently created player race in the most recently created game in your database, use the appropriate values in these two lines
		,(select max(GameID) from FCT_Game) as GameID
		,(select max(RaceID) from FCT_Race where NPR = 0) as RaceID
		--------------
		
		--leave this line alone
		,(select max(ProjectID) from FCT_IndustrialProjects) as ProjectID
		--------------
)

,CTE_ClassList as
(
	-- in these lines, specify the classes to build components for, and how many of each class you want to build
	SELECT 
			5 as ShipsToBuild
			, 'Bonk' as ClassName					
	--to include more classes, just add more lines like this 
	union ALL	SELECT 0 , 'xxx' 					--replace the number and the class name in each line
	union ALL	SELECT 0 , 'xxSwoop'

)
,CTE_ExcludeComponents as
(
	-- components listed here will be excluded from the build tasks
	-- (useful if you are building some components at a different colony)
	select 'xxx10cm Railgun V10/C1' as ComponentName
	union all select 'zzzzBFC R192-TS6840 (SW) 114t'													--to exclude more components, just add more lines like this
	--union all select 'Engineering Spaces'	
	
)
,CTE_ReduceComponents as
(
	-- the build quantity of components listed here will be reduced by the amounts specified
	-- (you can put negative numbers here if you want to increase the order for a given component, but only if that component is actually a component of one of the listed ships)
	select 
		'xxTractor Beam' as ComponentName
		, 2 as ReductionAmount
	-- to reduce build amounts for more components, just add more lines like this one
	union all select 'component 2', 1 											
)

--nothing to change here
,CTE_ComponentStockpiles as
(
	SELECT
		p.PopName
		,p.PopulationID
		,sdc.Name
		,pc.Amount
		,sdc.SDComponentID
		
	FROM
		FCT_PopComponent as pc
	inner JOIN
		FCT_Population as p
	on
		p.PopulationID = pc.PopulationID
	inner JOIN	
		const as c 
	on 
		c.RaceID = p.RaceID 
	and 
		p.PopName like c.PopulationName || '%'
	inner JOIN
		FCT_ShipDesignComponents as sdc
	on
		sdc.SDComponentID = pc.ComponentID
)

--select * from CTE_ComponentStockpiles							--you can uncomment this line and just run the script to here if you want to see all your component stockpiles

--nothing to change here
,CTE_MasterComponentList as 
(
	SELECT
		*
		,row_number() over (order by ComponentTotalCost desc) as ComponentTotalCostRank
	FROM
	(
		SELECT
			*
			,x.NumComponentMaster - ifnull(cs.Amount,0) - ifnull(rc.ReductionAmount,0) as NumComponent
			,x.Cost * (x.NumComponentMaster - ifnull(cs.Amount,0) - ifnull(rc.ReductionAmount,0)) as ComponentTotalCost			
		FROM
		(
			SELECT
				sdc.SDComponentID
				,sdc.Name
				,sdc.Cost
				,sdc.Duranium
				,sdc.Neutronium
				,sdc.Corbomite
				,sdc.Tritanium
				,sdc.Boronide
				,sdc.Mercassium
				,sdc.Vendarite
				,sdc.Sorium
				,sdc.Uridium
				,sdc.Corundium
				,sdc.Gallicite	
				,sum(cc.NumComponent * cl.ShipsToBuild) as NumComponentMaster
			FROM
				FCT_ShipClass as sc
			inner join const as c on c.RaceID = sc.RaceID
			inner JOIN
				CTE_ClassList as cl
			ON
				cl.ClassName = sc.ClassName
			inner join
				FCT_ClassComponent as cc
			on
				cc.ClassID = sc.ShipClassID
			inner join
				FCT_ShipDesignComponents as sdc
			on
				sdc.SDComponentID = cc.ComponentID
			left JOIN
				CTE_ExcludeComponents as xc
			on
				xc.ComponentName = sdc.Name
			WHERE
				sc.ClassShippingLineID = 0
			AND
				sdc.ComponentTypeID <> 11 --(excludes armor, since you can't build that with factories)	
			AND
				sdc.Prototype = 0 --(excludes prototype components)
			AND
				xc.ComponentName is null
			group by
				sdc.SDComponentID
		) AS x
		inner join const as c on 1=1
		left JOIN
				CTE_ReduceComponents as rc
			on
				rc.ComponentName = x.Name
		left JOIN
			CTE_ComponentStockpiles as cs
		on
			cs.SDComponentID = x.SDComponentID
		AND
			cs.PopName like c.PopulationName || '%'
		AND
			c.UseStockpile = 1
		WHERE
			x.NumComponentMaster - ifnull(cs.Amount,0) - ifnull(rc.ReductionAmount,0) > 0
	) as x			
)

--select * from CTE_MasterComponentList order by Name

--nothing to change here
,CTE_TotalCost as
(
	SELECT
		sum(x.Cost * x.NumComponent) as TotalCost
	FROM
		CTE_MasterComponentList as x
)

--select * from CTE_TotalCost

--nothing to change here
,CTE_Queue as
(
	SELECT
		p.PopulationID
		,p.SpeciesID
		,ifnull(max(ip.Queue),0) as MaxQueue
	FROM
		FCT_Population as p
	left JOIN
		FCT_IndustrialProjects as ip
	on
		ip.PopulationID = p.PopulationID
	AND
		ip.ProductionType not in (1,2) --(ignores missile and fighter queues)
	inner join 
		const as c 
	on 
		c.RaceID = p.RaceID 
	and 
		p.PopName like c.PopulationName || '%'
)

--select * from CTE_Queue

--Here is where you control the script's mode--selecting data or writing to the database.
--First, run the script with the INSERT INTO line commented out.
--Then, if the result looks correct, uncomment the INSERT INTO line and run the script again

--	INSERT INTO FCT_IndustrialProjects(		ProjectID	,GameID	,RaceID	,PopulationID	,SpeciesID	,Percentage	,ProductionType	,ProductionID	,RefitClassID	,WealthUse	,Amount	,PartialCompletion	,ProdPerUnit	,Description	,Pause	,Queue	,FuelRequired	,Duranium	,Neutronium	,Corbomite	,Tritanium	,Boronide	,Mercassium	,Vendarite	,Sorium	,Uridium	,Corundium	,Gallicite)
SELECT
	c.ProjectID + list.ComponentTotalCostRank	as	ProjectID
	,c.GameID	as	GameID
	,c.RaceID	as	RaceID
	,CTE_Queue.PopulationID	as	PopulationID
	,CTE_Queue.SpeciesID as	SpeciesID
	,1.0 * c.IndustryPercentageToUse * list.ComponentTotalCost / x.TotalCost	as	Percentage
	,3	as	ProductionType
	,list.SDComponentID	as	ProductionID -- (ComponentID)
	,0	as	RefitClassID
	,40	as	WealthUse
	,list.NumComponent	as	Amount
	,0	as	PartialCompletion
	,list.cost	as	ProdPerUnit -- (component cost)
	,list.Name	as	Description -- (component name)
	,c.Pause	as	Pause
	,CASE
		WHEN c.Queue = 0 THEN 0
		ELSE CTE_Queue.MaxQueue + list.ComponentTotalCostRank
		END as	Queue
	,0	as	FuelRequired
	,list.Duranium
	,list.Neutronium
	,list.Corbomite
	,list.Tritanium
	,list.Boronide
	,list.Mercassium
	,list.Vendarite
	,list.Sorium
	,list.Uridium
	,list.Corundium
	,list.Gallicite
FROM
	CTE_MasterComponentList as list
inner join CTE_TotalCost as x on 1=1
inner JOIN const as c ON 1 = 1
inner JOIN CTE_Queue on 1=1
order by list.ComponentTotalCostRank
