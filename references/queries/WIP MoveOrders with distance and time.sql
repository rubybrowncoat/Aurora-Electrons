SELECT
	*
FROM
	FCT_MoveOrders
	
	
-- select distinct DestinationType from DIM_MoveAction
-- 1	JP		MoveActionID 
--					1 = transit (NewWarpPointID = transit jp destination, NewSystemID = system destination )
--					64 = stabilize
--					112 = send message
-- 2	system body
-- 4	survey location
-- 5	escape point  (what is this?)
-- 6	contact
-- 8	wreck	MoveActionID 107 = salvage
-- 10	fleet
-- 12	LP		MoveActionID 
--					2 = moveto
--					124 = jump (destinationitemID = jump lp destination)
