with const as
(
	select 
		GameID
		,'Salve 002' as SourceShipName
		,'Horse 009' as TargetShipName
		,0 as XferInstallations
		,1 as XferMinerals
		,1 as XferShipComponents
		--,1 as XferTechData				-- not needed, it's a separate table
	FROM
		vw_const
)

,CTE_ShipIDS as
(
	select 
		src.ShipID as SourceShipID 
		,trg.ShipID as TargetShipID
	from 
		const
	inner join
		FCT_Ship as src on src.GameID = const.GameID AND src.ShipName = const.SourceShipName
	inner join
		FCT_Ship as trg on trg.GameID = const.GameID AND trg.ShipName = const.TargetShipName	
)
-- /*
select * from CTE_ShipIDs
-- */

--
/*
--combine cargos
,CTE_CargoTotals as
(
	SELECT
		c.TargetShipID, CargoTypeID, CargoID, sum(Amount) as TotalAmount
	FROM
		FCT_ShipCargo as sc
	inner JOIN
		CTE_ShipIDs as c on sc.ShipID in (c.SourceShipID,c.TargetShipID)
	group by CargoTypeID, sc.CargoID
)
select * from CTE_CargoTotals

--
/*
update FCT_ShipCargo as sc
	set Amount = x.TotalAmount
FROM
	CTE_CargoTotals as x
WHERE
	x.CargoTypeID = sc.CargoTypeID
AND
	x.CargoID = sc.CargoID
AND
	x.TargetShipID = sc.ShipID
*/

-- 
/*
select * from FCT_ShipTechData where ShipID = (select SourceShipID from CTE_ShipIDS) or ShipID = (select TargetShipID from CTE_ShipIDS)
-- */

-- 
/*
update FCT_ShipTechData set ShipID = (select TargetShipID from CTE_ShipIDS) where ShipID = (select SourceShipID from CTE_ShipIDS) --(select ShipID from FCT_Ship where GameID = (select GameID from const) AND ShipName = (select SourceShipName from const))
-- */

/* 
--
select * from FCT_ShipCargo where ShipID = (select SourceShipID from CTE_ShipIDS)
select * from FCT_ShipCargo where ShipID = (select TargetShipID from CTE_ShipIDS) order by CargoID
*/

--
/*
update FCT_ShipCargo 
	set ShipID = (select ShipID from FCT_Ship where GameID = (select GameID from const) AND ShipName = (select TargetShipName from const)) 
where 
	ShipID = (select ShipID from FCT_Ship where GameID = (select GameID from const) AND ShipName = (select SourceShipName from const))
AND
(
	(CargoTypeID = 2 and (select XferInstallations from const) = 1)
	or
	(CargoTypeID = 3 and (select XferMinerals from const) = 1)
	or
	(CargoTypeID = 6 and (select XferShipComponents from const) = 1)
)
--*/