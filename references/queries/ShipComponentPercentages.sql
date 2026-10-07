WITH const AS (
	SELECT

	c.RaceID
	,c.GameID
	,0 as minimumComponentCost
	,1 as IndustryPCT
	,0 as IncludeObsoleteClasses		
	,1 as IncludeObsoleteComponents		
	,1 as IncludePrototypeComponents
	,1 as IncludeStandardEquipment	-- components that don't require research
	,1 as IncludeFighters	
	,1 as IncludeUnlockedClasses
	,0 as IncludeCapturedClasses
	,'%BFC R320-TS10150 203t%' as ComponentNameLike		-- empty string returns all components
	,'' as ClassNameLike					-- empty string returns all classes
		FROM
	vw_const as c
),

CTE_ComponentList as 
(
	SELECT
		sc.ClassName
		,sc.RaceID
		,sc.Obsolete as ClassObsolete
		,sc.OtherRaceClassID
		,hd.Description as HullDescription
		,sc.Cost as ClassCost
		,sc.TotalNumber
		,sc.Size as ClassSize
		,sdc.SDComponentID
		,sdc.Name
		,sdc.Cost
		,sdc.Size
		,sdc.Cost/sdc.Size as CostPerHS
		,cc.NumComponent
		,sdc.Prototype
		,sdc.GameID
		,rt.Obsolete
	FROM
		FCT_ShipClass as sc
	left JOIN
		FCT_HullDescription as hd
	on
		hd.HullDescriptionID = sc.HullDescriptionID
	inner join
		FCT_ClassComponent as cc
	on
		cc.ClassID = sc.ShipClassID
	inner join
		FCT_ShipDesignComponents as sdc
	on
		sdc.SDComponentID = cc.ComponentID
	inner JOIN
		const as c
	ON
		c.raceID = sc.RaceID
	AND
		(c.IncludeStandardEquipment = 1 or c.GameID = sdc.GameID)
	AND
		(c.ComponentNameLike = '' or sdc.Name like c.ComponentNameLike)
		
	--AND
	--	sc.ClassName = const.designName
	AND
		sdc.Cost * cc.NumComponent >= c.minimumComponentCost
	--AND		sdc.ComponentTypeID <> 11 --exclude armor
	inner JOIN
		FCT_RaceTech as rt
	on
		rt.TechID = sdc.SDComponentID
	AND
		rt.RaceID = sc.RaceID
	WHERE
		(c.ClassNameLike = '' or sc.ClassName like c.ClassNameLike)
	AND
		sc.ClassShippingLineID = 0
	AND
		(c.IncludeObsoleteClasses = 1 or sc.Obsolete = 0)
	AND
		(c.IncludeObsoleteComponents = 1 or rt.Obsolete = 0)
	AND
		(c.IncludePrototypeComponents = 1 or sdc.Prototype = 0)
	AND
		(c.IncludeFighters = 1 or sc.Size > 10)
	AND
		(c.IncludeUnlockedClasses = 1 or sc.Locked = 1)
	AND
		(c.IncludeCapturedClasses = 1 or sc.OtherRaceClassID = 0)		
		
)

,CTE_TotalCost as
(
	SELECT
		x.ClassName
		,sum(x.Cost * x.NumComponent) as TotalCost
	FROM
		CTE_ComponentList as x
	group by
		x.ClassName
)

SELECT
	list.RaceID
	,list.HullDescription
	,list.ClassName
	,list.ClassObsolete
	,list.OtherRaceClassID
	,list.ClassCost
	,list.TotalNumber as ShipsBuilt
	--,list.ClassSize * 50 as ClassTons
	,list.Name
	,list.Prototype
	,list.Obsolete
	--,list.GameID
	,list.NumComponent
	,list.NumComponent * list.Cost as Cost
	,list.NumComponent * list.Cost / x.TotalCost * c.IndustryPCT * 100 as Pct
	,list.Size * 50 as TonsEach
	,list.CostPerHS
FROM
	CTE_ComponentList as list
inner join
	CTE_TotalCost as x
on
	x.ClassName = list.ClassName
inner JOIN const as c ON 1 = 1
order by
	--list.ClassCost desc
	--list.ClassName,
	--list.CostPerHS desc,	
	--list.Name,
	list.HullDescription, list.ClassName
	--list.Name, list.ClassName
	--list.CostPerHS desc, list.Name
	